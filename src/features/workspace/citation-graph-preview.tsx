import {
  AlertTriangle,
  Check,
  Clipboard,
  Download,
  FileText,
  Filter,
  Link2,
  MessageSquareText,
  Network,
  Quote,
  Search,
  ShieldCheck,
  Sparkles,
  StickyNote,
  Target,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";

type CitationGraphNodeKind = "claim" | "source" | "note" | "question";
type CitationGraphNodeStatus = "supported" | "review" | "planned" | "inferred";
type CitationGraphEdgeType = "supports" | "derived-from" | "mentions" | "questions" | "contrasts-with";
type CitationGraphFocus = "all" | "selected" | "path" | "cluster";

interface CitationGraphCluster {
  id: string;
  label: string;
  nodeIds: string[];
  edgeCount: number;
}

interface CitationGraphNode {
  id: string;
  kind: CitationGraphNodeKind;
  title: string;
  subtitle: string;
  excerpt: string;
  origin: string;
  status: CitationGraphNodeStatus;
  confidence: number;
  tags: string[];
}

interface CitationGraphEdge {
  id: string;
  sourceId: string;
  targetId: string;
  type: CitationGraphEdgeType;
  label: string;
  evidence: string;
}

const nodes: readonly CitationGraphNode[] = [
  {
    id: "claim-provenance",
    kind: "claim",
    title: "Provenance should survive synthesis",
    subtitle: "Claim · grounded",
    excerpt: "Source identity, revision, and omission reasons should remain visible after retrieval and summarization.",
    origin: "Working thesis",
    status: "supported",
    confidence: 0.92,
    tags: ["provenance", "evidence"],
  },
  {
    id: "claim-uncertainty",
    kind: "claim",
    title: "Uncertainty belongs beside the answer",
    subtitle: "Claim · reviewable",
    excerpt: "Stale, inferred, or incomplete evidence should not silently become active context.",
    origin: "Research notebook",
    status: "review",
    confidence: 0.78,
    tags: ["uncertainty", "memory"],
  },
  {
    id: "claim-route",
    kind: "claim",
    title: "Route choice is part of evidence",
    subtitle: "Claim · architecture",
    excerpt: "A reader should be able to inspect why a route, model, or context slice was selected.",
    origin: "Harness architecture notes",
    status: "supported",
    confidence: 0.84,
    tags: ["routing", "harness"],
  },
  {
    id: "source-harness",
    kind: "source",
    title: "Harness architecture notes",
    subtitle: "Document · Omnia design docs",
    excerpt: "Freeze intent, context, route, and idempotency before provider dispatch.",
    origin: "Omnia design docs",
    status: "supported",
    confidence: 0.96,
    tags: ["harness", "architecture", "runs"],
  },
  {
    id: "source-context",
    kind: "source",
    title: "Context compiler research",
    subtitle: "Document · Research collection",
    excerpt: "Selected evidence needs scope, revision, hash, reason, and a visible omission record.",
    origin: "Research collection",
    status: "supported",
    confidence: 0.89,
    tags: ["retrieval", "evidence", "provenance"],
  },
  {
    id: "source-memory",
    kind: "source",
    title: "Local-first memory discussion",
    subtitle: "Conversation · Research notebook chat",
    excerpt: "Memory proposals should stay reviewable and reversible; inferred facts must not silently become context.",
    origin: "Research notebook chat",
    status: "review",
    confidence: 0.68,
    tags: ["memory", "review", "policy"],
  },
  {
    id: "source-provider",
    kind: "source",
    title: "Provider freshness scratchpad",
    subtitle: "Connected source · not retrieved",
    excerpt: "Freshness and live source checks stay in a planned lane until an approved connector exists.",
    origin: "Connected source placeholder",
    status: "planned",
    confidence: 0.32,
    tags: ["providers", "freshness", "planned"],
  },
  {
    id: "note-thesis",
    kind: "note",
    title: "Working thesis",
    subtitle: "Note · product direction",
    excerpt: "Every answer should expose source selection, route choice, and uncertainty in one workspace.",
    origin: "Research notebook",
    status: "inferred",
    confidence: 0.74,
    tags: ["thesis", "product"],
  },
  {
    id: "note-open-question",
    kind: "note",
    title: "Open question: source freshness",
    subtitle: "Note · follow-up",
    excerpt: "How can a notebook show that a citation became stale while preserving the original answer?",
    origin: "Research notebook",
    status: "review",
    confidence: 0.56,
    tags: ["freshness", "open question"],
  },
  {
    id: "question-context",
    kind: "question",
    title: "What enters provider context?",
    subtitle: "Question · unresolved",
    excerpt: "Which source details should be promoted into a context freeze, and which should remain visible only?",
    origin: "Research brief",
    status: "review",
    confidence: 0.48,
    tags: ["context", "scope"],
  },
];

const edges: readonly CitationGraphEdge[] = [
  { id: "edge-1", sourceId: "claim-provenance", targetId: "source-harness", type: "supports", label: "supported by", evidence: "Stable design note" },
  { id: "edge-2", sourceId: "claim-provenance", targetId: "source-context", type: "supports", label: "supported by", evidence: "Research excerpt" },
  { id: "edge-3", sourceId: "claim-uncertainty", targetId: "source-memory", type: "supports", label: "supported by", evidence: "Conversation excerpt" },
  { id: "edge-4", sourceId: "claim-uncertainty", targetId: "source-context", type: "derived-from", label: "derived from", evidence: "Evidence policy" },
  { id: "edge-5", sourceId: "claim-route", targetId: "source-harness", type: "supports", label: "supported by", evidence: "Harness contract" },
  { id: "edge-6", sourceId: "note-thesis", targetId: "claim-provenance", type: "mentions", label: "captures", evidence: "Renderer-local note link" },
  { id: "edge-7", sourceId: "note-thesis", targetId: "claim-route", type: "mentions", label: "captures", evidence: "Renderer-local note link" },
  { id: "edge-8", sourceId: "note-open-question", targetId: "source-provider", type: "questions", label: "questions", evidence: "Planned connector" },
  { id: "edge-9", sourceId: "question-context", targetId: "claim-provenance", type: "contrasts-with", label: "needs decision", evidence: "Open research question" },
  { id: "edge-10", sourceId: "question-context", targetId: "source-context", type: "derived-from", label: "asks about", evidence: "Context compiler excerpt" },
];

const kindLabels: Record<CitationGraphNodeKind, string> = {
  claim: "Claims",
  source: "Sources",
  note: "Notes",
  question: "Questions",
};

const statusLabels: Record<CitationGraphNodeStatus, string> = {
  supported: "Supported",
  review: "Needs review",
  planned: "Planned",
  inferred: "Inferred",
};

const edgeLabels: Record<CitationGraphEdgeType, string> = {
  supports: "Supports",
  "derived-from": "Derived from",
  mentions: "Mentions",
  questions: "Questions",
  "contrasts-with": "Needs decision",
};

function nodeIcon(kind: CitationGraphNodeKind) {
  if (kind === "claim") return <Target size={15} />;
  if (kind === "source") return <FileText size={15} />;
  if (kind === "note") return <StickyNote size={15} />;
  return <MessageSquareText size={15} />;
}

function toPercent(confidence: number): string {
  return `${Math.round(confidence * 100)}%`;
}

function connectedClusters(
  candidateNodes: readonly CitationGraphNode[],
  candidateEdges: readonly CitationGraphEdge[],
): CitationGraphCluster[] {
  const adjacency = new Map<string, Set<string>>();
  candidateNodes.forEach((node) => adjacency.set(node.id, new Set()));
  candidateEdges.forEach((edge) => {
    adjacency.get(edge.sourceId)?.add(edge.targetId);
    adjacency.get(edge.targetId)?.add(edge.sourceId);
  });

  const remaining = new Set(candidateNodes.map((node) => node.id));
  const components: string[][] = [];
  while (remaining.size > 0) {
    const seed = [...remaining].sort()[0]!;
    const queue = [seed];
    const component: string[] = [];
    remaining.delete(seed);
    while (queue.length > 0) {
      const current = queue.shift()!;
      component.push(current);
      [...(adjacency.get(current) ?? [])].sort().forEach((neighbor) => {
        if (!remaining.has(neighbor)) return;
        remaining.delete(neighbor);
        queue.push(neighbor);
      });
    }
    components.push(component.sort());
  }

  return components
    .sort((left, right) => right.length - left.length || left[0]!.localeCompare(right[0]!))
    .map((nodeIds, index) => ({
      id: `cluster-${index + 1}-${nodeIds[0]}`,
      label: `Cluster ${index + 1}`,
      nodeIds,
      edgeCount: candidateEdges.filter((edge) => nodeIds.includes(edge.sourceId) && nodeIds.includes(edge.targetId)).length,
    }));
}

function shortestPathNodeIds(
  startId: string | undefined,
  targetId: string | undefined,
  candidateEdges: readonly CitationGraphEdge[],
): Set<string> {
  if (!startId || !targetId) return new Set([startId, targetId].filter((id): id is string => Boolean(id)));
  if (startId === targetId) return new Set([startId]);

  const adjacency = new Map<string, string[]>();
  candidateEdges.forEach((edge) => {
    adjacency.set(edge.sourceId, [...(adjacency.get(edge.sourceId) ?? []), edge.targetId]);
    adjacency.set(edge.targetId, [...(adjacency.get(edge.targetId) ?? []), edge.sourceId]);
  });
  adjacency.forEach((neighbors, id) => adjacency.set(id, [...new Set(neighbors)].sort()));

  const previous = new Map<string, string | null>([[startId, null]]);
  const queue = [startId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === targetId) break;
    (adjacency.get(current) ?? []).forEach((neighbor) => {
      if (previous.has(neighbor)) return;
      previous.set(neighbor, current);
      queue.push(neighbor);
    });
  }
  if (!previous.has(targetId)) return new Set([startId, targetId]);

  const path: string[] = [];
  let cursor: string | null = targetId;
  while (cursor) {
    path.unshift(cursor);
    cursor = previous.get(cursor) ?? null;
  }
  return new Set(path);
}

function focusViewLabel(focus: CitationGraphFocus): string {
  if (focus === "selected") return "selected neighborhood";
  if (focus === "path") return "shortest path";
  if (focus === "cluster") return "connected cluster";
  return "all matching records";
}

function serializeGraph(
  format: "json" | "markdown",
  visibleNodes: readonly CitationGraphNode[],
  visibleEdges: readonly CitationGraphEdge[],
  query: string,
  focus: CitationGraphFocus,
  focusDetails?: { pathStart?: string; pathTarget?: string; cluster?: string },
) {
  const payload = {
    schema: "omnia.citation-graph.preview.v1",
    scope: "renderer-session",
    view: focus === "selected" ? "selected-neighborhood" : focus === "path" ? "shortest-path" : focus === "cluster" ? "connected-cluster" : "all-matching-records",
    query,
    nodes: visibleNodes,
    edges: visibleEdges,
    ...(focusDetails ? { focusDetails } : {}),
    boundary: "Preview only; no retrieval, provider request, source verification, or durable write.",
  };
  if (format === "json") return JSON.stringify(payload, null, 2);
  const nodeLines = visibleNodes.map((node) => `- ${node.title} (${kindLabels[node.kind]}, ${statusLabels[node.status]}, ${toPercent(node.confidence)} confidence)`);
  const edgeLines = visibleEdges.map((edge) => `- ${edge.label}: ${edge.sourceId} -> ${edge.targetId} (${edge.evidence})`);
  return [
    "# Omnia citation graph preview",
    "",
    `- Query: ${query || "(all nodes)"}`,
    `- View: ${focusViewLabel(focus)}`,
    ...(focusDetails?.pathStart && focusDetails.pathTarget ? [`- Path: ${focusDetails.pathStart} → ${focusDetails.pathTarget}`] : []),
    ...(focusDetails?.cluster ? [`- Cluster: ${focusDetails.cluster}`] : []),
    `- Nodes: ${visibleNodes.length}`,
    `- Links: ${visibleEdges.length}`,
    "",
    "## Nodes",
    "",
    ...(nodeLines.length > 0 ? nodeLines : ["- No matching nodes."]),
    "",
    "## Links",
    "",
    ...(edgeLines.length > 0 ? edgeLines : ["- No matching links."]),
    "",
    "> Preview only · Renderer-local · No retrieval, provider request, source verification, or durable write.",
    "",
  ].join("\n");
}

function downloadGraphPreview(payload: string, format: "json" | "markdown"): boolean {
  if (typeof document === "undefined" || typeof URL === "undefined") return false;
  const url = URL.createObjectURL(new Blob([payload], { type: format === "json" ? "application/json" : "text/markdown" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `omnia-citation-graph-preview.${format === "json" ? "json" : "md"}`;
  anchor.click();
  URL.revokeObjectURL(url);
  return true;
}

export function CitationGraphPreview() {
  const defaultPathStartId = nodes[0]?.id ?? "";
  const defaultPathTargetId = nodes[3]?.id ?? nodes[1]?.id ?? "";
  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<CitationGraphNodeKind | "all">("all");
  const [statusFilter, setStatusFilter] = useState<CitationGraphNodeStatus | "all">("all");
  const [edgeFilter, setEdgeFilter] = useState<CitationGraphEdgeType | "all">("all");
  const [focus, setFocus] = useState<CitationGraphFocus>("all");
  const [selectedNodeId, setSelectedNodeId] = useState(nodes[0]?.id ?? "");
  const [pathStartId, setPathStartId] = useState(defaultPathStartId);
  const [pathTargetId, setPathTargetId] = useState(defaultPathTargetId);
  const [clusterFilter, setClusterFilter] = useState("all");
  const [exportOpen, setExportOpen] = useState(false);
  const [exportFormat, setExportFormat] = useState<"json" | "markdown">("json");
  const [copied, setCopied] = useState(false);
  const [status, setStatus] = useState("Citation graph is a renderer-local evidence map.");

  const matchingNodes = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return nodes.filter((node) => {
      const matchesQuery = !normalized || `${node.title} ${node.subtitle} ${node.excerpt} ${node.origin} ${node.tags.join(" ")}`.toLowerCase().includes(normalized);
      const matchesKind = kindFilter === "all" || node.kind === kindFilter;
      const matchesStatus = statusFilter === "all" || node.status === statusFilter;
      return matchesQuery && matchesKind && matchesStatus;
    });
  }, [kindFilter, query, statusFilter]);

  const matchingNodeIds = useMemo(() => new Set(matchingNodes.map((node) => node.id)), [matchingNodes]);
  const focusAnchor = matchingNodes.find((node) => node.id === selectedNodeId) ?? matchingNodes[0] ?? null;
  const matchingEdges = useMemo(
    () => edges.filter((edge) => matchingNodeIds.has(edge.sourceId) && matchingNodeIds.has(edge.targetId) && (edgeFilter === "all" || edge.type === edgeFilter)),
    [edgeFilter, matchingNodeIds],
  );
  const pathStartNode = matchingNodes.find((node) => node.id === pathStartId) ?? matchingNodes[0] ?? null;
  const pathTargetNode = matchingNodes.find((node) => node.id === pathTargetId && node.id !== pathStartNode?.id)
    ?? matchingNodes.find((node) => node.id !== pathStartNode?.id)
    ?? pathStartNode;
  const clusters = useMemo(() => connectedClusters(matchingNodes, matchingEdges), [matchingEdges, matchingNodes]);
  const activeCluster = clusters.find((cluster) => cluster.id === clusterFilter) ?? null;
  const pathNodeIds = useMemo(
    () => shortestPathNodeIds(pathStartNode?.id, pathTargetNode?.id, matchingEdges),
    [matchingEdges, pathStartNode?.id, pathTargetNode?.id],
  );
  const focusedNodeIds = useMemo(() => {
    if (focus === "path") return pathNodeIds;
    if (focus === "cluster" && activeCluster) return new Set(activeCluster.nodeIds);
    if (focus !== "selected" || !focusAnchor) return matchingNodeIds;
    const ids = new Set([focusAnchor.id]);
    matchingEdges.forEach((edge) => {
      if (edge.sourceId === focusAnchor.id) ids.add(edge.targetId);
      if (edge.targetId === focusAnchor.id) ids.add(edge.sourceId);
    });
    return ids;
  }, [activeCluster, focus, focusAnchor, matchingEdges, matchingNodeIds, pathNodeIds]);
  const visibleNodes = useMemo(() => matchingNodes.filter((node) => focusedNodeIds.has(node.id)), [focusedNodeIds, matchingNodes]);
  const visibleNodeIds = useMemo(() => new Set(visibleNodes.map((node) => node.id)), [visibleNodes]);
  const visibleEdges = useMemo(
    () => edges.filter((edge) => visibleNodeIds.has(edge.sourceId) && visibleNodeIds.has(edge.targetId) && (edgeFilter === "all" || edge.type === edgeFilter)),
    [edgeFilter, visibleNodeIds],
  );
  const selectedNode = visibleNodes.find((node) => node.id === selectedNodeId) ?? visibleNodes[0] ?? null;
  const selectedEdges = selectedNode ? edges.filter((edge) => edge.sourceId === selectedNode.id || edge.targetId === selectedNode.id) : [];
  const focusDetails = useMemo(() => {
    if (focus === "path" && pathStartNode && pathTargetNode) return { pathStart: pathStartNode.title, pathTarget: pathTargetNode.title };
    if (focus === "cluster" && activeCluster) return { cluster: `${activeCluster.label} · ${activeCluster.nodeIds.length} records` };
    return undefined;
  }, [activeCluster, focus, pathStartNode, pathTargetNode]);
  const exportPayload = useMemo(() => serializeGraph(exportFormat, visibleNodes, visibleEdges, query.trim(), focus, focusDetails), [exportFormat, focus, focusDetails, query, visibleEdges, visibleNodes]);
  const groupedNodes = useMemo(() => {
    const groups: Record<CitationGraphNodeKind, CitationGraphNode[]> = { claim: [], source: [], note: [], question: [] };
    visibleNodes.forEach((node) => groups[node.kind].push(node));
    return groups;
  }, [visibleNodes]);
  const connectedNodeCount = new Set(visibleEdges.flatMap((edge) => [edge.sourceId, edge.targetId])).size;
  const reviewCount = visibleNodes.filter((node) => node.status === "review").length;
  const coverage = visibleNodes.length === 0 ? 0 : Math.round((connectedNodeCount / visibleNodes.length) * 100);

  const resetFilters = () => {
    setQuery("");
    setKindFilter("all");
    setStatusFilter("all");
    setEdgeFilter("all");
    setFocus("all");
    setPathStartId(defaultPathStartId);
    setPathTargetId(defaultPathTargetId);
    setClusterFilter("all");
    setStatus("Graph filters reset for this preview session.");
  };

  const copyExport = async () => {
    if (!navigator.clipboard?.writeText) {
      setStatus("Clipboard access is unavailable; no citation graph preview was copied.");
      return;
    }
    try {
      await navigator.clipboard.writeText(exportPayload);
      setCopied(true);
      setStatus(`Copied the renderer-local ${exportFormat.toUpperCase()} citation graph preview.`);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setStatus("Clipboard access was denied; no citation graph preview was copied.");
    }
  };

  return (
    <section className="citation-graph-preview" aria-label="Citation graph preview">
      <header className="citation-graph__header">
        <div className="citation-graph__title-block">
          <span className="eyebrow"><Network size={14} /> Evidence graph</span>
          <h2>Citation graph</h2>
          <p>Trace claims to sources, notes, and open questions without losing the evidence boundary.</p>
        </div>
        <div className="citation-graph__header-actions">
          <span className="citation-graph__boundary-badge"><Sparkles size={12} /> Preview only</span>
          <button type="button" className="button button--secondary" onClick={() => setExportOpen((open) => !open)}>
            {exportOpen ? <X size={14} /> : <Clipboard size={14} />} {exportOpen ? "Hide export" : "Export graph"}
          </button>
        </div>
      </header>

      <div className="citation-graph__boundary" role="note">
        <ShieldCheck size={15} />
        <span><strong>No retrieval or verification is running here.</strong> This graph links renderer-local research records; source freshness, provider requests, native citations, and durable graph revisions remain planned.</span>
      </div>

      <div className="citation-graph__metrics" aria-label="Citation graph summary">
        <article><span><Network size={16} /></span><small>Visible nodes</small><strong>{visibleNodes.length}/{nodes.length}</strong></article>
        <article><span><Link2 size={16} /></span><small>Visible links</small><strong>{visibleEdges.length}/{edges.length}</strong></article>
        <article><span><AlertTriangle size={16} /></span><small>Needs review</small><strong>{reviewCount}</strong></article>
        <article><span><ShieldCheck size={16} /></span><small>Graph coverage</small><strong>{coverage}%</strong></article>
      </div>

      <div className="citation-graph__controls" role="group" aria-label="Citation graph filters">
        <label className="citation-graph__search"><Search size={14} /><input aria-label="Search citation graph" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search claims, sources, notes" />{query ? <button type="button" aria-label="Clear citation graph search" onClick={() => setQuery("")}><X size={13} /></button> : null}</label>
        <label><span>Kind</span><select aria-label="Citation graph node kind" value={kindFilter} onChange={(event) => setKindFilter(event.target.value as CitationGraphNodeKind | "all")}><option value="all">All kinds</option>{Object.entries(kindLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label><span>Status</span><select aria-label="Citation graph node status" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as CitationGraphNodeStatus | "all")}><option value="all">All statuses</option>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label><span>Link</span><select aria-label="Citation graph edge type" value={edgeFilter} onChange={(event) => setEdgeFilter(event.target.value as CitationGraphEdgeType | "all")}><option value="all">All links</option>{Object.entries(edgeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label><span>Focus</span><select aria-label="Citation graph focus mode" value={focus} onChange={(event) => { const nextFocus = event.target.value as CitationGraphFocus; setFocus(nextFocus); setStatus(nextFocus === "selected" ? "Showing the selected node and its directly connected records." : nextFocus === "path" ? "Showing the shortest renderer-local path between two records." : nextFocus === "cluster" ? "Showing one connected cluster at a time." : "Showing all records that match the current filters."); }}><option value="all">All matching records</option><option value="selected">Selected neighborhood</option><option value="path">Shortest path</option><option value="cluster">Connected clusters</option></select></label>
        {focus === "path" ? <>
          <label><span>Path from</span><select aria-label="Citation graph path start" value={pathStartNode?.id ?? ""} onChange={(event) => setPathStartId(event.target.value)}>{matchingNodes.map((node) => <option key={node.id} value={node.id}>{node.title}</option>)}</select></label>
          <label><span>Path to</span><select aria-label="Citation graph path target" value={pathTargetNode?.id ?? ""} onChange={(event) => setPathTargetId(event.target.value)}>{matchingNodes.map((node) => <option key={node.id} value={node.id}>{node.title}</option>)}</select></label>
        </> : null}
        {focus === "cluster" ? <label><span>Cluster</span><select aria-label="Citation graph cluster" value={clusterFilter} onChange={(event) => setClusterFilter(event.target.value)}><option value="all">All connected clusters</option>{clusters.map((cluster) => <option key={cluster.id} value={cluster.id}>{cluster.label} · {cluster.nodeIds.length} records</option>)}</select></label> : null}
        <button type="button" className="button button--ghost" onClick={resetFilters}><Filter size={13} /> Reset</button>
      </div>

      {focus === "path" ? <section className="citation-graph__lens-panel" role="region" aria-label="Citation graph path inspector">
        <div className="citation-graph__lens-heading"><span><Link2 size={14} /><strong>Shortest path inspector</strong></span><small>{pathNodeIds.size > 1 ? `${pathNodeIds.size - 1} hop${pathNodeIds.size - 1 === 1 ? "" : "s"}` : "No connected path"}</small></div>
        <p>{pathStartNode?.title ?? "No start record"} <span aria-hidden="true">→</span> {pathTargetNode?.title ?? "No target record"}</p>
        <small>Renderer-local breadth-first path over the visible evidence links. It does not prove causal provenance or source freshness.</small>
      </section> : null}

      {focus === "cluster" ? <section className="citation-graph__lens-panel" role="region" aria-label="Citation graph cluster inspector">
        <div className="citation-graph__lens-heading"><span><Network size={14} /><strong>Connected cluster inspector</strong></span><small>{clusters.length} cluster{clusters.length === 1 ? "" : "s"}</small></div>
        <div className="citation-graph__cluster-list">
          {clusters.map((cluster) => <button type="button" key={cluster.id} className={clusterFilter === cluster.id ? "citation-graph__cluster-card citation-graph__cluster-card--selected" : "citation-graph__cluster-card"} aria-pressed={clusterFilter === cluster.id} onClick={() => setClusterFilter(cluster.id)}><strong>{cluster.label}</strong><span>{cluster.nodeIds.length} records · {cluster.edgeCount} links</span></button>)}
          {clusters.length === 0 ? <span className="citation-graph__muted">No connected clusters match the current filters.</span> : null}
        </div>
      </section> : null}

      <div className="citation-graph__workspace">
        <div className="citation-graph__board" aria-label="Citation graph node board">
          {(Object.keys(kindLabels) as CitationGraphNodeKind[]).map((kind) => (
            <section className="citation-graph__lane" key={kind} aria-label={`${kindLabels[kind]} lane`}>
              <header><span>{nodeIcon(kind)}<strong>{kindLabels[kind]}</strong></span><small>{groupedNodes[kind].length}</small></header>
              <div className="citation-graph__lane-list">
                {groupedNodes[kind].map((node) => (
                  <button type="button" key={node.id} className={selectedNode?.id === node.id ? "citation-graph__node citation-graph__node--selected" : "citation-graph__node"} aria-pressed={selectedNode?.id === node.id} onClick={() => setSelectedNodeId(node.id)}>
                    <span className="citation-graph__node-icon">{nodeIcon(node.kind)}</span>
                    <span className="citation-graph__node-body"><strong>{node.title}</strong><small>{node.subtitle}</small><em className={`citation-graph__status citation-graph__status--${node.status}`}>{statusLabels[node.status]} · {toPercent(node.confidence)}</em></span>
                  </button>
                ))}
                {groupedNodes[kind].length === 0 ? <span className="citation-graph__empty">No matching {kindLabels[kind].toLowerCase()}.</span> : null}
              </div>
            </section>
          ))}
        </div>

        <aside className="citation-graph__detail" aria-label="Selected citation graph node">
          {selectedNode ? (
            <>
              <div className="citation-graph__detail-heading"><span className={`citation-graph__detail-icon citation-graph__detail-icon--${selectedNode.kind}`}>{nodeIcon(selectedNode.kind)}</span><div><span className="eyebrow">Selected {selectedNode.kind}</span><h3>{selectedNode.title}</h3></div></div>
              <p className="citation-graph__detail-subtitle">{selectedNode.subtitle} · {selectedNode.origin}</p>
              <div className={`citation-graph__detail-status citation-graph__detail-status--${selectedNode.status}`}><strong>{statusLabels[selectedNode.status]}</strong><span>{toPercent(selectedNode.confidence)} confidence</span></div>
              <blockquote><Quote size={14} />{selectedNode.excerpt}</blockquote>
              <div className="citation-graph__tags">{selectedNode.tags.map((tag) => <span key={tag}>#{tag}</span>)}</div>
              <div className="citation-graph__relations"><div className="citation-graph__section-heading"><span><Link2 size={14} /><strong>Connected records</strong></span><small>{selectedEdges.length}</small></div>{selectedEdges.map((edge) => { const otherId = edge.sourceId === selectedNode.id ? edge.targetId : edge.sourceId; const other = nodes.find((node) => node.id === otherId); return <button type="button" className="citation-graph__relation" key={edge.id} onClick={() => setSelectedNodeId(other?.id ?? selectedNode.id)}><span className={`citation-graph__relation-kind citation-graph__relation-kind--${other?.kind ?? "source"}`}>{other ? nodeIcon(other.kind) : <Link2 size={14} />}</span><span><strong>{other?.title ?? "Unknown record"}</strong><small>{edge.label} · {edge.evidence}</small></span></button>; })}</div>
              <p className="citation-graph__muted">Links are local evidence annotations. They do not prove that a source was fetched, current, or independently verified.</p>
            </>
          ) : (
            <div className="citation-graph__empty citation-graph__empty--detail"><Search size={22} /><strong>No matching record</strong><span>Adjust the filters to inspect a graph node.</span></div>
          )}
        </aside>
      </div>

      {exportOpen ? <section className="citation-graph__export" role="region" aria-label="Citation graph export preview"><header><div><span className="eyebrow">Portable evidence map</span><h3>Export preview</h3><p>Copy or download the filtered renderer-local graph.</p></div><div><label><span>Format</span><select aria-label="Citation graph export format" value={exportFormat} onChange={(event) => setExportFormat(event.target.value as "json" | "markdown")}><option value="json">JSON</option><option value="markdown">Markdown</option></select></label><button type="button" className="button button--ghost" onClick={() => void copyExport()}>{copied ? <Check size={13} /> : <Clipboard size={13} />} {copied ? "Copied" : "Copy"}</button><button type="button" className="button button--secondary" onClick={() => setStatus(downloadGraphPreview(exportPayload, exportFormat) ? "Started a browser download of the renderer-local citation graph preview." : "Browser download is unavailable; no graph file was written.")}><Download size={13} /> Download</button></div></header><pre tabIndex={0}><code>{exportPayload}</code></pre></section> : null}

      <p className="citation-graph__status-line" role="status" aria-live="polite"><Sparkles size={13} />{status}</p>
    </section>
  );
}

export default CitationGraphPreview;
