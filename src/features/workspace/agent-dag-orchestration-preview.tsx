import {
  AlertTriangle,
  ArrowDown,
  CheckCircle2,
  CircleDot,
  Clipboard,
  Download,
  Eye,
  GitBranch,
  Info,
  Pause,
  Play,
  RotateCcw,
  ShieldCheck,
  Workflow,
  XCircle,
} from "lucide-react";
import { useMemo, useState } from "react";

import AgentOrchestrationPromptPreview from "./agent-orchestration-prompt-preview";

export type AgentDagNodeState = "ready" | "running" | "blocked" | "completed" | "failed" | "paused";

export type AgentDagNode = {
  readonly id: string;
  readonly label: string;
  readonly role: string;
  readonly owner: string;
  readonly state: AgentDagNodeState;
  readonly dependencies: readonly string[];
  readonly mode?: string;
  readonly detail?: string;
  readonly budget?: string;
};

export type AgentDagLayer = {
  readonly depth: number;
  readonly nodeIds: readonly string[];
};

export type AgentDagModel = {
  readonly nodes: readonly AgentDagNode[];
  readonly edges: readonly { readonly id: string; readonly from: string; readonly to: string }[];
  readonly layers: readonly AgentDagLayer[];
  readonly roots: readonly string[];
  readonly leaves: readonly string[];
  readonly readyIds: readonly string[];
  readonly topologicalOrder: readonly string[];
  readonly criticalPath: readonly string[];
  readonly unknownDependencyCount: number;
  readonly selfDependencyCount: number;
  readonly duplicateDependencyCount: number;
  readonly duplicateNodeIdCount: number;
  readonly cycleNodeIds: readonly string[];
};

export type AgentDagOrchestrationPreviewProps = {
  readonly nodes?: readonly AgentDagNode[];
};

const defaultNodes: readonly AgentDagNode[] = [
  {
    id: "agent:intake",
    label: "Intake & scope",
    role: "Planner",
    owner: "Omnia core",
    state: "completed",
    dependencies: [],
    mode: "triage",
    detail: "Normalize the user request into bounded work packets.",
    budget: "4k tokens",
  },
  {
    id: "agent:research",
    label: "Research context",
    role: "Researcher",
    owner: "Research lane",
    state: "running",
    dependencies: ["agent:intake"],
    mode: "parallel",
    detail: "Collect cited context and identify unresolved assumptions.",
    budget: "16k tokens",
  },
  {
    id: "agent:design",
    label: "Design proposal",
    role: "Architect",
    owner: "Design lane",
    state: "ready",
    dependencies: ["agent:intake"],
    mode: "parallel",
    detail: "Shape a UI and contract proposal from the scoped request.",
    budget: "10k tokens",
  },
  {
    id: "agent:build",
    label: "Build implementation",
    role: "Builder",
    owner: "Delivery lane",
    state: "blocked",
    dependencies: ["agent:research", "agent:design"],
    mode: "fan-in",
    detail: "Wait for research and design evidence before changing code.",
    budget: "24k tokens",
  },
  {
    id: "agent:review",
    label: "Review & handoff",
    role: "Reviewer",
    owner: "Quality lane",
    state: "paused",
    dependencies: ["agent:build"],
    mode: "approval",
    detail: "Prepare a concise handoff with known boundaries and open checks.",
    budget: "8k tokens",
  },
  {
    id: "agent:publish",
    label: "Publish preview",
    role: "Presenter",
    owner: "Omnia UI",
    state: "ready",
    dependencies: ["agent:review"],
    mode: "preview",
    detail: "Expose a renderer-local result for the user to inspect.",
    budget: "3k tokens",
  },
];

const stateLabels: Record<AgentDagNodeState, string> = {
  ready: "Ready",
  running: "Running",
  blocked: "Blocked",
  completed: "Completed",
  failed: "Failed",
  paused: "Paused",
};

function stateIcon(state: AgentDagNodeState) {
  if (state === "completed") return <CheckCircle2 size={13} aria-hidden="true" />;
  if (state === "failed") return <XCircle size={13} aria-hidden="true" />;
  if (state === "blocked" || state === "paused") return <AlertTriangle size={13} aria-hidden="true" />;
  if (state === "running") return <Play size={13} aria-hidden="true" />;
  return <CircleDot size={13} aria-hidden="true" />;
}

/**
 * Build a deterministic renderer-local DAG model. This helper only inspects
 * the supplied fixture: it does not schedule agents, release leases, or
 * infer native execution authority.
 */
export function buildAgentDagModel(nodes: readonly AgentDagNode[]): AgentDagModel {
  const byId = new Map<string, AgentDagNode>();
  let duplicateNodeIdCount = 0;
  for (const node of nodes) {
    if (byId.has(node.id)) duplicateNodeIdCount += 1;
    else byId.set(node.id, node);
  }

  const ids = [...byId.keys()];
  const known = new Set(ids);
  const dependencies = new Map<string, string[]>();
  const children = new Map<string, string[]>(ids.map((id) => [id, []]));
  const indegree = new Map<string, number>(ids.map((id) => [id, 0]));
  let unknownDependencyCount = 0;
  let selfDependencyCount = 0;
  let duplicateDependencyCount = 0;

  for (const id of ids) {
    const node = byId.get(id)!;
    const seen = new Set<string>();
    const valid: string[] = [];
    for (const dependency of node.dependencies) {
      if (dependency === id) {
        selfDependencyCount += 1;
        continue;
      }
      if (!known.has(dependency)) {
        unknownDependencyCount += 1;
        continue;
      }
      if (seen.has(dependency)) {
        duplicateDependencyCount += 1;
        continue;
      }
      seen.add(dependency);
      valid.push(dependency);
      children.get(dependency)?.push(id);
    }
    dependencies.set(id, valid);
    indegree.set(id, valid.length);
  }

  const roots = ids.filter((id) => (indegree.get(id) ?? 0) === 0);
  const queue = [...roots];
  const topologicalOrder: string[] = [];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const id = queue[cursor];
    if (!id) continue;
    topologicalOrder.push(id);
    for (const child of children.get(id) ?? []) {
      const next = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, next);
      if (next === 0) queue.push(child);
    }
  }
  const cycleNodeIds = ids.filter((id) => !topologicalOrder.includes(id));
  topologicalOrder.push(...cycleNodeIds);

  const depth = new Map<string, number>();
  for (const id of topologicalOrder) {
    const depthFromDependencies = (dependencies.get(id) ?? [])
      .filter((dependency) => !cycleNodeIds.includes(dependency))
      .map((dependency) => (depth.get(dependency) ?? 0) + 1);
    depth.set(id, Math.max(0, ...depthFromDependencies));
  }

  const layerMap = new Map<number, string[]>();
  for (const id of topologicalOrder) {
    const layer = layerMap.get(depth.get(id) ?? 0) ?? [];
    layer.push(id);
    layerMap.set(depth.get(id) ?? 0, layer);
  }
  const layers = [...layerMap.entries()]
    .sort(([left], [right]) => left - right)
    .map(([layerDepth, nodeIds]) => ({ depth: layerDepth, nodeIds }));

  const leaves = ids.filter((id) => (children.get(id)?.length ?? 0) === 0);
  const readyIds = ids.filter((id) => {
    const node = byId.get(id)!;
    if (node.state !== "ready") return false;
    return (dependencies.get(id) ?? []).every((dependency) => byId.get(dependency)?.state === "completed");
  });

  const pathLengths = new Map<string, number>();
  const previous = new Map<string, string>();
  for (const id of topologicalOrder) {
    const parents = (dependencies.get(id) ?? []).filter((dependency) => !cycleNodeIds.includes(dependency));
    let bestParent: string | undefined;
    let bestLength = 0;
    for (const parent of parents) {
      const length = pathLengths.get(parent) ?? 0;
      if (length > bestLength) {
        bestParent = parent;
        bestLength = length;
      }
    }
    pathLengths.set(id, bestLength + 1);
    if (bestParent) previous.set(id, bestParent);
  }
  const criticalLeaf = [...pathLengths.entries()].sort((left, right) => right[1] - left[1])[0]?.[0];
  const criticalPath: string[] = [];
  let current = criticalLeaf;
  while (current) {
    criticalPath.unshift(current);
    current = previous.get(current);
  }

  const edges = ids.flatMap((to) => (dependencies.get(to) ?? []).map((from) => ({ id: `${from}->${to}`, from, to })));
  return {
    nodes: ids.map((id) => byId.get(id)!),
    edges,
    layers,
    roots,
    leaves,
    readyIds,
    topologicalOrder,
    criticalPath,
    unknownDependencyCount,
    selfDependencyCount,
    duplicateDependencyCount,
    duplicateNodeIdCount,
    cycleNodeIds,
  };
}

export function serializeAgentDagPreview(model: AgentDagModel): string {
  return JSON.stringify({
    schema: "omnia.agent-dag-orchestration.preview.v1",
    scope: "renderer-session",
    executionDisposition: "preview-only",
    roots: model.roots,
    leaves: model.leaves,
    readyIds: model.readyIds,
    criticalPath: model.criticalPath,
    topologicalOrder: model.topologicalOrder,
    diagnostics: {
      unknownDependencyCount: model.unknownDependencyCount,
      selfDependencyCount: model.selfDependencyCount,
      duplicateDependencyCount: model.duplicateDependencyCount,
      duplicateNodeIdCount: model.duplicateNodeIdCount,
      cycleNodeIds: model.cycleNodeIds,
    },
    nodes: model.nodes.map(({ id, label, role, owner, state, dependencies, mode }) => ({ id, label, role, owner, state, dependencies, mode })),
    edges: model.edges,
    boundary: [
      "No native agent spawn or scheduler call",
      "No provider request, lease mutation, filesystem write, or durable persistence",
      "Readiness and critical path are derived from visible fixture state only",
    ],
  }, null, 2);
}

function stateTone(state: AgentDagNodeState): string {
  return state === "completed" ? "completed" : state === "running" ? "running" : state === "ready" ? "ready" : state === "failed" ? "failed" : "attention";
}

function titleFor(nodes: readonly AgentDagNode[], id: string): string {
  return nodes.find((node) => node.id === id)?.label ?? id;
}

export default function AgentDagOrchestrationPreview({ nodes = defaultNodes }: AgentDagOrchestrationPreviewProps) {
  const model = useMemo(() => buildAgentDagModel(nodes), [nodes]);
  const [selectedId, setSelectedId] = useState<string>(model.nodes[0]?.id ?? "");
  const [showCompleted, setShowCompleted] = useState(true);
  const [focusCriticalPath, setFocusCriticalPath] = useState(false);
  const [status, setStatus] = useState("Select an agent node to inspect its gate and fan-out.");
  const selected = model.nodes.find((node) => node.id === selectedId) ?? model.nodes[0];
  const criticalSet = useMemo(() => new Set(model.criticalPath), [model.criticalPath]);
  const byId = useMemo(() => new Map(model.nodes.map((node) => [node.id, node])), [model.nodes]);
  const visibleIds = useMemo(() => new Set(model.nodes.filter((node) => showCompleted || node.state !== "completed").map((node) => node.id)), [model.nodes, showCompleted]);
  const downstream = selected ? model.nodes.filter((node) => node.dependencies.includes(selected.id)) : [];
  const upstream = selected ? selected.dependencies.flatMap((id) => byId.get(id) ? [byId.get(id)!] : []) : [];

  const announce = (message: string) => setStatus(message);
  const reset = () => {
    setShowCompleted(true);
    setFocusCriticalPath(false);
    setSelectedId(model.nodes[0]?.id ?? "");
    announce("DAG view reset; no agent state or queue was changed.");
  };
  const copyExport = async () => {
    const text = serializeAgentDagPreview(model);
    try {
      await navigator.clipboard?.writeText(text);
      announce("Preview JSON copied locally; no durable export was created.");
    } catch {
      announce("Preview JSON prepared; clipboard access is unavailable in this renderer.");
    }
  };

  return (
    <>
      <AgentOrchestrationPromptPreview />
      <section className="agent-dag-preview" aria-labelledby="agent-dag-preview-heading">
      <header className="agent-dag-preview__header">
        <div>
          <span className="eyebrow"><Workflow size={13} /> Agent DAG orchestration</span>
          <h3 id="agent-dag-preview-heading">Coordinate parallel agents with visible gates</h3>
          <p>Inspect fan-out, fan-in, readiness, and critical-path pressure before a future native orchestrator is connected.</p>
        </div>
        <span className="agent-dag-preview__badge"><Eye size={12} /> Preview only</span>
      </header>

      <p className="agent-dag-preview__boundary"><ShieldCheck size={13} /> Renderer-local graph · no spawn, scheduler, provider, lease, filesystem, or durable persistence authority.</p>

      <div className="agent-dag-preview__metrics" aria-label="Agent DAG summary">
        <div><strong>{model.nodes.length}</strong><span>agent nodes</span></div>
        <div><strong>{model.edges.length}</strong><span>dependency edges</span></div>
        <div><strong>{model.readyIds.length}</strong><span>gate-ready</span></div>
        <div><strong>{model.criticalPath.length}</strong><span>critical path</span></div>
        <div><strong>{model.cycleNodeIds.length || model.unknownDependencyCount}</strong><span>{model.cycleNodeIds.length ? "cycle nodes" : "missing refs"}</span></div>
      </div>

      <div className="agent-dag-preview__toolbar" aria-label="Agent DAG controls">
        <label><input type="checkbox" checked={showCompleted} onChange={(event) => setShowCompleted(event.target.checked)} /> Show completed</label>
        <label><input type="checkbox" checked={focusCriticalPath} onChange={(event) => setFocusCriticalPath(event.target.checked)} /> Focus critical path</label>
        <div className="agent-dag-preview__actions">
          <button type="button" className="button button--ghost" onClick={() => announce("Branch spawn rehearsal recorded locally; no agent was spawned.")}><GitBranch size={13} /> Rehearse branch</button>
          <button type="button" className="button button--ghost" onClick={() => announce("Fan-in gate rehearsal recorded locally; no queue was released.")}><ArrowDown size={13} /> Rehearse fan-in</button>
          <button type="button" className="button button--ghost" onClick={() => void copyExport()}><Clipboard size={13} /> Copy JSON</button>
          <button type="button" className="button button--ghost" onClick={() => announce("Download remains a planned durable export; JSON is available in the browser session only.")}><Download size={13} /> Export plan</button>
          <button type="button" className="button button--ghost" aria-label="Reset DAG view" onClick={reset}><RotateCcw size={13} /></button>
        </div>
      </div>

      <div className="agent-dag-preview__diagnostics" aria-label="DAG diagnostics">
        <span className={model.cycleNodeIds.length ? "is-warning" : "is-ready"}>{model.cycleNodeIds.length ? `${model.cycleNodeIds.length} cycle node${model.cycleNodeIds.length === 1 ? "" : "s"}` : "Acyclic visible graph"}</span>
        <span>{model.unknownDependencyCount} unknown refs</span>
        <span>{model.duplicateDependencyCount} duplicate refs</span>
        <span>{model.selfDependencyCount} self refs</span>
      </div>

      <div className="agent-dag-preview__layout">
        <div className="agent-dag-preview__graph" role="list" aria-label="Agent DAG layers">
          {model.layers.map((layer) => {
            const visibleNodes = layer.nodeIds.map((id) => byId.get(id)).filter((node): node is AgentDagNode => node !== undefined && visibleIds.has(node.id));
            if (visibleNodes.length === 0) return null;
            return (
              <section key={layer.depth} className="agent-dag-preview__layer" role="listitem" aria-label={`Agent DAG layer ${layer.depth}`}>
                <header><span>Layer {layer.depth}</span><small>{layer.depth === 0 ? "Roots / independent work" : "After dependency gate"}</small></header>
                <div className="agent-dag-preview__nodes">
                  {visibleNodes.map((node) => {
                    const isFocused = !focusCriticalPath || criticalSet.has(node.id);
                    return (
                      <button
                        type="button"
                        key={node.id}
                        className={`agent-dag-preview__node agent-dag-preview__node--${stateTone(node.state)}${selected?.id === node.id ? " is-selected" : ""}${isFocused ? "" : " is-muted"}`}
                        onClick={() => { setSelectedId(node.id); announce(`${node.label} selected; ${node.dependencies.length} declared prerequisite${node.dependencies.length === 1 ? "" : "s"}.`); }}
                        aria-label={`${node.label}. ${stateLabels[node.state]}`}
                      >
                        <span className="agent-dag-preview__node-icon">{stateIcon(node.state)}</span>
                        <span className="agent-dag-preview__node-copy"><strong>{node.label}</strong><small>{node.role} · {node.mode ?? "managed"}</small><em>{node.owner}</em></span>
                        <span className="agent-dag-preview__node-state">{stateLabels[node.state]}</span>
                      </button>
                    );
                  })}
                </div>
                {layer.depth < model.layers.at(-1)!.depth ? <div className="agent-dag-preview__connector" aria-hidden="true"><ArrowDown size={13} /></div> : null}
              </section>
            );
          })}
        </div>

        <aside className="agent-dag-preview__detail" aria-label="Selected agent DAG node">
          {selected ? (
            <>
              <div className="agent-dag-preview__detail-heading"><span className={`agent-dag-preview__state agent-dag-preview__state--${stateTone(selected.state)}`}>{stateIcon(selected.state)} {stateLabels[selected.state]}</span><code>{selected.id}</code></div>
              <h4>{selected.label}</h4>
              <p>{selected.detail}</p>
              <dl>
                <div><dt>Role / owner</dt><dd>{selected.role} · {selected.owner}</dd></div>
                <div><dt>Mode / budget</dt><dd>{selected.mode ?? "managed"} · {selected.budget ?? "not specified"}</dd></div>
                <div><dt>Prerequisites</dt><dd>{upstream.length ? upstream.map((node) => node.label).join(", ") : "None visible"}</dd></div>
                <div><dt>Downstream</dt><dd>{downstream.length ? downstream.map((node) => node.label).join(", ") : "No visible dependents"}</dd></div>
              </dl>
              <div className="agent-dag-preview__detail-actions">
                <button type="button" className="button button--ghost" onClick={() => announce(`${selected.label} branch pause is a renderer rehearsal only; agent state is unchanged.`)}><Pause size={13} /> Preview pause</button>
                <button type="button" className="button button--ghost" onClick={() => announce(`${selected.label} resume is a renderer rehearsal only; no lease or scheduler was touched.`)}><Play size={13} /> Preview resume</button>
              </div>
            </>
          ) : <p className="agent-dag-preview__empty">No visible agent node selected.</p>}
        </aside>
      </div>

      <div className="agent-dag-preview__critical" aria-label="Critical path summary">
        <span><GitBranch size={13} /> Critical path</span>
        <p>{model.criticalPath.length ? model.criticalPath.map((id) => titleFor(model.nodes, id)).join(" → ") : "No path available"}</p>
      </div>

      <p className="agent-dag-preview__status" role="status" aria-live="polite">{status}</p>
      <p className="agent-dag-preview__footnote"><Info size={13} /> This is a planning projection from visible fixture data. It does not prove readiness, change permissions, start agents, or create a native orchestration receipt.</p>
      </section>
    </>
  );
}
