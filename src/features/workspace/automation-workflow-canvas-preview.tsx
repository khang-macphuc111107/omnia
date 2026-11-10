import {
  ArrowDown,
  Eye,
  GitBranch,
  Minus,
  Plus,
  RotateCcw,
  SlidersHorizontal,
  Sparkles,
  Workflow,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useMemo, useState, type CSSProperties } from "react";

import type { AutomationPlanStep, AutomationPlanStepKind } from "./automation-workflow-plan-preview";

export type AutomationWorkflowCanvasLayout = "flow" | "lanes";

export type AutomationWorkflowCanvasNode = {
  id: string;
  step: AutomationPlanStep;
  depth: number;
  lane: number;
  order: number;
  x: number;
  y: number;
};

export type AutomationWorkflowCanvasEdge = {
  id: string;
  from: string;
  to: string;
};

export type AutomationWorkflowCanvasModel = {
  nodes: AutomationWorkflowCanvasNode[];
  edges: AutomationWorkflowCanvasEdge[];
  width: number;
  height: number;
  roots: string[];
  leaves: string[];
  invalidEdgeCount: number;
};

export type AutomationWorkflowCanvasPreviewProps = {
  steps: readonly AutomationPlanStep[];
  selectedStepId?: string;
  onSelectStep?: (stepId: string) => void;
  onToggleStep?: (stepId: string) => void;
  onStatus?: (message: string) => void;
};

const NODE_WIDTH = 236;
const NODE_HEIGHT = 100;
const COLUMN_GAP = 68;
const ROW_GAP = 30;
const PADDING = 28;

const kindLabels: Record<AutomationPlanStepKind, string> = {
  trigger: "Trigger",
  context: "Context",
  condition: "Condition",
  action: "Action",
  approval: "Approval",
  notify: "Notify",
};

const kindTones: Record<AutomationPlanStepKind, string> = {
  trigger: "violet",
  context: "blue",
  condition: "amber",
  action: "teal",
  approval: "coral",
  notify: "slate",
};

function uniqueDependencies(step: AutomationPlanStep, known: ReadonlySet<string>): string[] {
  const seen = new Set<string>();
  return step.dependsOn.filter((dependency) => {
    if (dependency === step.id || !known.has(dependency) || seen.has(dependency)) return false;
    seen.add(dependency);
    return true;
  });
}

/**
 * Build a deterministic renderer-local layout for the visible workflow DAG.
 * Coordinates are presentation metadata only; they never imply scheduler
 * ordering, native execution, or an authoritative workflow mutation.
 */
export function buildAutomationWorkflowCanvasModel(
  steps: readonly AutomationPlanStep[],
  layout: AutomationWorkflowCanvasLayout = "lanes",
): AutomationWorkflowCanvasModel {
  const byId = new Map<string, AutomationPlanStep>();
  for (const step of steps) {
    if (!byId.has(step.id)) byId.set(step.id, step);
  }
  const ids = [...byId.keys()];
  const known = new Set(ids);
  const dependencies = new Map(ids.map((id) => [id, uniqueDependencies(byId.get(id)!, known)]));
  const children = new Map<string, string[]>(ids.map((id) => [id, []]));
  const indegree = new Map(ids.map((id) => [id, dependencies.get(id)?.length ?? 0]));
  let invalidEdgeCount = 0;

  for (const step of steps) {
    const unique = new Set<string>();
    for (const dependency of step.dependsOn) {
      if (!known.has(dependency) || dependency === step.id || unique.has(dependency)) invalidEdgeCount += 1;
      unique.add(dependency);
    }
  }

  for (const id of ids) {
    for (const dependency of dependencies.get(id) ?? []) children.get(dependency)?.push(id);
  }

  const roots = ids.filter((id) => (indegree.get(id) ?? 0) === 0);
  const queue = [...roots];
  const order: string[] = [];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const id = queue[cursor];
    if (!id) continue;
    order.push(id);
    for (const child of children.get(id) ?? []) {
      const next = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, next);
      if (next === 0) queue.push(child);
    }
  }
  for (const id of ids) {
    if (!order.includes(id)) order.push(id);
  }

  const depth = new Map<string, number>();
  for (const id of order) {
    const value = Math.max(0, ...(dependencies.get(id) ?? []).map((dependency) => (depth.get(dependency) ?? 0) + 1));
    depth.set(id, value);
  }

  const lanes = new Map<number, string[]>();
  for (const id of order) {
    const lane = depth.get(id) ?? 0;
    const current = lanes.get(lane) ?? [];
    current.push(id);
    lanes.set(lane, current);
  }

  const laneById = new Map<string, number>();
  for (const idsAtDepth of lanes.values()) idsAtDepth.forEach((id, index) => laneById.set(id, index));

  const nodes = order.map((id, orderIndex): AutomationWorkflowCanvasNode => {
    const step = byId.get(id)!;
    const nodeDepth = depth.get(id) ?? 0;
    const lane = laneById.get(id) ?? 0;
    const x = PADDING + (layout === "flow" ? orderIndex : nodeDepth) * (NODE_WIDTH + COLUMN_GAP);
    const y = PADDING + (layout === "flow" ? 0 : lane) * (NODE_HEIGHT + ROW_GAP);
    return { id, step, depth: nodeDepth, lane, order: orderIndex, x, y };
  });

  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const edges: AutomationWorkflowCanvasEdge[] = [];
  for (const node of nodes) {
    for (const dependency of dependencies.get(node.id) ?? []) {
      if (nodeById.has(dependency)) edges.push({ id: `${dependency}->${node.id}`, from: dependency, to: node.id });
    }
  }

  const maxX = nodes.reduce((max, node) => Math.max(max, node.x), 0);
  const maxY = nodes.reduce((max, node) => Math.max(max, node.y), 0);
  const leaves = ids.filter((id) => (children.get(id)?.length ?? 0) === 0);
  return {
    nodes,
    edges,
    roots,
    leaves,
    invalidEdgeCount,
    width: Math.max(320, maxX + NODE_WIDTH + PADDING),
    height: Math.max(180, maxY + NODE_HEIGHT + PADDING),
  };
}

export function serializeAutomationWorkflowCanvas(
  model: AutomationWorkflowCanvasModel,
  layout: AutomationWorkflowCanvasLayout,
): string {
  return JSON.stringify({
    schema: "omnia.automation-workflow-canvas.preview.v1",
    scope: "renderer-session",
    executionDisposition: "preview-only",
    layout,
    roots: model.roots,
    leaves: model.leaves,
    invalidEdgeCount: model.invalidEdgeCount,
    nodes: model.nodes.map(({ id, depth, lane, order, x, y, step }) => ({
      id,
      depth,
      lane,
      order,
      x,
      y,
      kind: step.kind,
      label: step.label,
      enabled: step.enabled,
      dependsOn: [...step.dependsOn],
    })),
    edges: model.edges,
    boundary: [
      "No durable workflow write",
      "No scheduler, provider, connector, notification, or native execution",
      "Coordinates and edges are renderer-local layout metadata",
    ],
  }, null, 2);
}

function collectFocusIds(model: AutomationWorkflowCanvasModel, selectedStepId: string): Set<string> {
  if (!selectedStepId) return new Set();
  const focus = new Set<string>([selectedStepId]);
  const dependencies = new Map(model.nodes.map((node) => [node.id, node.step.dependsOn]));
  const children = new Map<string, string[]>();
  for (const edge of model.edges) {
    const current = children.get(edge.from) ?? [];
    current.push(edge.to);
    children.set(edge.from, current);
  }
  const visit = (ids: readonly string[]) => {
    for (const id of ids) {
      if (focus.has(id)) continue;
      focus.add(id);
      visit(dependencies.get(id) ?? []);
      visit(children.get(id) ?? []);
    }
  };
  visit([selectedStepId]);
  return focus;
}

function edgePath(source: AutomationWorkflowCanvasNode, target: AutomationWorkflowCanvasNode): string {
  const startX = source.x + NODE_WIDTH;
  const startY = source.y + NODE_HEIGHT / 2;
  const endX = target.x;
  const endY = target.y + NODE_HEIGHT / 2;
  const bend = Math.max(28, Math.abs(endX - startX) / 2);
  return `M ${startX} ${startY} C ${startX + bend} ${startY}, ${endX - bend} ${endY}, ${endX} ${endY}`;
}

export function AutomationWorkflowCanvasPreview({
  steps,
  selectedStepId,
  onSelectStep,
  onToggleStep,
  onStatus,
}: AutomationWorkflowCanvasPreviewProps) {
  const [layout, setLayout] = useState<AutomationWorkflowCanvasLayout>("lanes");
  const [zoom, setZoom] = useState(1);
  const [showDisabled, setShowDisabled] = useState(true);
  const [focusPath, setFocusPath] = useState(false);
  const [status, setStatus] = useState("Select a node to inspect its renderer-local dependency path.");
  const model = useMemo(() => buildAutomationWorkflowCanvasModel(steps, layout), [layout, steps]);
  const focusIds = useMemo(() => focusPath ? collectFocusIds(model, selectedStepId ?? "") : null, [focusPath, model, selectedStepId]);
  const visibleNodes = model.nodes.filter((node) => showDisabled || node.step.enabled || node.id === selectedStepId);
  const visibleIds = new Set(visibleNodes.map((node) => node.id));
  const nodeById = new Map(model.nodes.map((node) => [node.id, node]));
  const visibleEdges = model.edges.filter((edge) => visibleIds.has(edge.from) && visibleIds.has(edge.to));
  const stageStyle = { width: model.width, height: model.height, transform: `scale(${zoom})` } as CSSProperties;
  const shellStyle = { width: model.width * zoom, height: model.height * zoom } as CSSProperties;

  const announce = (message: string) => {
    setStatus(message);
    onStatus?.(message);
  };

  const changeLayout = (next: AutomationWorkflowCanvasLayout) => {
    setLayout(next);
    announce(`${next === "lanes" ? "Dependency lanes" : "Linear flow"} layout selected; coordinates remain renderer-local.`);
  };

  const changeZoom = (next: number) => {
    const clamped = Math.max(0.7, Math.min(1.35, Number(next.toFixed(2))));
    setZoom(clamped);
  };

  const resetView = () => {
    setLayout("lanes");
    setZoom(1);
    setShowDisabled(true);
    setFocusPath(false);
    announce("Canvas view reset; workflow steps and edges remain unchanged.");
  };

  return (
    <section className="automation-canvas" aria-labelledby="automation-canvas-heading">
      <header className="automation-canvas__header">
        <div>
          <span className="eyebrow"><Workflow size={13} /> Visual workflow canvas</span>
          <h5 id="automation-canvas-heading">Dependency canvas</h5>
          <p>Inspect branches, gates, and review routes as a navigable graph before a future native runtime is wired.</p>
        </div>
        <span className="automation-canvas__badge"><Eye size={12} /> Preview only</span>
      </header>

      <p className="automation-canvas__boundary"><GitBranch size={13} /> Renderer-local canvas · {visibleNodes.length}/{model.nodes.length} nodes visible · {visibleEdges.length} edge{visibleEdges.length === 1 ? "" : "s"} · no scheduler, provider, connector, or durable write.</p>

      <div className="automation-canvas__toolbar" aria-label="Workflow canvas controls">
        <div className="automation-canvas__segmented" role="group" aria-label="Canvas layout">
          <button type="button" className="button button--ghost" aria-pressed={layout === "lanes"} onClick={() => changeLayout("lanes")}><GitBranch size={13} /> Dependency lanes</button>
          <button type="button" className="button button--ghost" aria-pressed={layout === "flow"} onClick={() => changeLayout("flow")}><ArrowDown size={13} /> Linear flow</button>
        </div>
        <label className="automation-canvas__check"><input type="checkbox" checked={showDisabled} onChange={(event) => setShowDisabled(event.target.checked)} /> Show disabled</label>
        <label className="automation-canvas__check"><input type="checkbox" checked={focusPath} onChange={(event) => setFocusPath(event.target.checked)} /> Focus selected path</label>
        <div className="automation-canvas__zoom" aria-label="Canvas zoom controls">
          <button type="button" className="button button--ghost" aria-label="Zoom out" onClick={() => changeZoom(zoom - 0.1)} disabled={zoom <= 0.7}><ZoomOut size={13} /></button>
          <input aria-label="Canvas zoom" type="range" min="0.7" max="1.35" step="0.05" value={zoom} onChange={(event) => changeZoom(Number(event.target.value))} />
          <span>{Math.round(zoom * 100)}%</span>
          <button type="button" className="button button--ghost" aria-label="Zoom in" onClick={() => changeZoom(zoom + 0.1)} disabled={zoom >= 1.35}><ZoomIn size={13} /></button>
          <button type="button" className="button button--ghost" aria-label="Reset canvas view" onClick={resetView}><RotateCcw size={13} /></button>
        </div>
      </div>

      <div className="automation-canvas__summary" aria-label="Workflow canvas summary">
        <span><SlidersHorizontal size={12} /> {model.nodes.length} nodes</span>
        <span><GitBranch size={12} /> {model.edges.length} dependencies</span>
        <span><Sparkles size={12} /> {model.roots.length} root{model.roots.length === 1 ? "" : "s"} · {model.leaves.length} leaf{model.leaves.length === 1 ? "" : "s"}</span>
        <span className={model.invalidEdgeCount ? "is-warning" : "is-ready"}>{model.invalidEdgeCount ? `${model.invalidEdgeCount} malformed edge${model.invalidEdgeCount === 1 ? "" : "s"}` : "Edges look consistent"}</span>
      </div>

      <div className="automation-canvas__viewport" aria-label="Workflow dependency canvas">
        <div className="automation-canvas__stage-shell" style={shellStyle}>
          <div className="automation-canvas__stage" style={stageStyle}>
            <svg className="automation-canvas__edges" viewBox={`0 0 ${model.width} ${model.height}`} aria-hidden="true">
              <defs>
                <marker id="automation-canvas-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M 0 0 L 7 3.5 L 0 7 z" fill="currentColor" /></marker>
              </defs>
              {visibleEdges.map((edge) => {
                const source = nodeById.get(edge.from);
                const target = nodeById.get(edge.to);
                if (!source || !target) return null;
                const highlighted = !focusIds || (focusIds.has(edge.from) && focusIds.has(edge.to));
                return <path key={edge.id} className={highlighted ? "is-highlighted" : "is-muted"} d={edgePath(source, target)} markerEnd="url(#automation-canvas-arrow)" />;
              })}
            </svg>
            {visibleNodes.map((node) => {
              const selected = node.id === selectedStepId;
              const focused = !focusIds || focusIds.has(node.id);
              return (
                <article key={node.id} className={`automation-canvas__node automation-canvas__node--${kindTones[node.step.kind]}${selected ? " is-selected" : ""}${focused ? "" : " is-muted"}`} style={{ left: node.x, top: node.y }}>
                  <button type="button" className="automation-canvas__node-main" aria-label={`Select ${node.step.label}`} aria-pressed={selected} onClick={() => { onSelectStep?.(node.id); announce(`${node.step.label} selected; ${node.step.dependsOn.length} declared dependency${node.step.dependsOn.length === 1 ? "" : "ies"}.`); }}>
                    <span className="automation-canvas__node-index">{node.order + 1}</span>
                    <span className="automation-canvas__node-copy"><strong>{node.step.label}</strong><small>{kindLabels[node.step.kind]} · {node.step.enabled ? "enabled" : "disabled"}</small><em>{node.step.detail}</em></span>
                  </button>
                  {onToggleStep ? <button type="button" className="automation-canvas__node-toggle" aria-label={`${node.step.enabled ? "Disable" : "Enable"} ${node.step.label}`} aria-pressed={node.step.enabled} onClick={() => { onToggleStep(node.id); announce(`${node.step.enabled ? "Disabled" : "Enabled"} ${node.step.label} in the renderer plan.`); }}>{node.step.enabled ? <Minus size={12} /> : <Plus size={12} />}</button> : null}
                </article>
              );
            })}
          </div>
        </div>
      </div>

      <div className="automation-canvas__footer"><span>{layout === "lanes" ? "Columns represent dependency depth; rows represent parallel branches." : "Nodes follow the current visible plan order."}</span><span>Selected: {selectedStepId ? model.nodes.find((node) => node.id === selectedStepId)?.step.label ?? "Unknown step" : "none"}</span></div>
      <p className="automation-canvas__status" role="status" aria-live="polite">{status}</p>
    </section>
  );
}

export default AutomationWorkflowCanvasPreview;
