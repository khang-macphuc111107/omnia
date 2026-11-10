import {
  AlertTriangle,
  ArrowDown,
  CheckCircle2,
  Clock3,
  GitBranch,
  Info,
  Network,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

export type SupervisorFlowTaskState = "running" | "ready" | "blocked" | "stale" | "waiting";

export interface SupervisorFlowTask {
  readonly id: string;
  readonly title: string;
  readonly mode: string;
  readonly state: SupervisorFlowTaskState;
  readonly owner: string;
  readonly dependencies: readonly string[];
}

export interface SupervisorFlowLayer {
  readonly depth: number;
  readonly taskIds: readonly string[];
}

export interface SupervisorFlowStats {
  readonly taskCount: number;
  readonly rootCount: number;
  readonly edgeCount: number;
  readonly attentionCount: number;
  readonly maxDepth: number;
}

/**
 * Derive deterministic dependency layers from the visible supervisor fixture.
 * Missing dependencies are ignored and cycles are collapsed to the current
 * branch so this helper never claims to have repaired a malformed graph.
 */
export function computeSupervisorFlowLayers(tasks: readonly SupervisorFlowTask[]): readonly SupervisorFlowLayer[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const memo = new Map<string, number>();

  const depthFor = (taskId: string, visiting: ReadonlySet<string> = new Set()): number => {
    const cached = memo.get(taskId);
    if (cached !== undefined) return cached;
    if (visiting.has(taskId)) return 0;
    const task = byId.get(taskId);
    if (!task || task.dependencies.length === 0) {
      memo.set(taskId, 0);
      return 0;
    }
    const nextVisiting = new Set(visiting);
    nextVisiting.add(taskId);
    const depth = Math.max(
      0,
      ...task.dependencies
        .filter((dependencyId) => byId.has(dependencyId))
        .map((dependencyId) => depthFor(dependencyId, nextVisiting) + 1),
    );
    memo.set(taskId, depth);
    return depth;
  };

  const layerMap = new Map<number, string[]>();
  tasks.forEach((task) => {
    const depth = depthFor(task.id);
    const current = layerMap.get(depth) ?? [];
    current.push(task.id);
    layerMap.set(depth, current);
  });

  return [...layerMap.entries()]
    .sort(([left], [right]) => left - right)
    .map(([depth, taskIds]) => ({ depth, taskIds }));
}

export function supervisorFlowStats(tasks: readonly SupervisorFlowTask[]): SupervisorFlowStats {
  const layers = computeSupervisorFlowLayers(tasks);
  return {
    taskCount: tasks.length,
    rootCount: layers[0]?.taskIds.length ?? 0,
    edgeCount: tasks.reduce((total, task) => total + task.dependencies.length, 0),
    attentionCount: tasks.filter((task) => task.state === "blocked" || task.state === "stale").length,
    maxDepth: layers.at(-1)?.depth ?? 0,
  };
}

function stateLabel(state: SupervisorFlowTaskState): string {
  return state === "ready" ? "Ready preview" : state.charAt(0).toUpperCase() + state.slice(1);
}

function stateTone(state: SupervisorFlowTaskState): string {
  if (state === "running") return "running";
  if (state === "ready") return "ready";
  if (state === "blocked" || state === "stale") return "attention";
  return "waiting";
}

function stateIcon(state: SupervisorFlowTaskState) {
  if (state === "running") return <Clock3 size={12} aria-hidden="true" />;
  if (state === "ready") return <CheckCircle2 size={12} aria-hidden="true" />;
  if (state === "blocked" || state === "stale") return <AlertTriangle size={12} aria-hidden="true" />;
  return <Network size={12} aria-hidden="true" />;
}

export interface AgentMeshSupervisorFlowProps {
  readonly tasks: readonly SupervisorFlowTask[];
  readonly selectedTaskId: string | null;
  readonly onSelectTask: (taskId: string) => void;
}

/**
 * Renderer-local dependency flow for the supervisor fixture. It is a visual
 * projection only: it neither computes native readiness nor mutates a queue.
 */
export function AgentMeshSupervisorFlow({ tasks, selectedTaskId, onSelectTask }: AgentMeshSupervisorFlowProps) {
  const [activeTaskId, setActiveTaskId] = useState<string | null>(selectedTaskId);
  useEffect(() => {
    setActiveTaskId(selectedTaskId);
  }, [selectedTaskId]);
  const byId = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);
  const layers = useMemo(() => computeSupervisorFlowLayers(tasks), [tasks]);
  const stats = useMemo(() => supervisorFlowStats(tasks), [tasks]);
  const selectedTask = activeTaskId ? byId.get(activeTaskId) ?? null : null;
  const downstream = selectedTask
    ? tasks.filter((task) => task.dependencies.includes(selectedTask.id))
    : [];

  return (
    <div className="agent-mesh-supervisor-preview__flow" aria-label="Supervisor dependency flow">
      <header className="agent-mesh-supervisor-preview__flow-heading">
        <div>
          <span className="eyebrow"><GitBranch size={13} /> Dependency map</span>
          <h3>Follow prerequisites before downstream work</h3>
          <p>Layers are derived from the visible task fixture so a reviewer can see why work is ready, held, or waiting.</p>
        </div>
        <span className="agent-mesh-supervisor-preview__flow-badge"><Network size={12} /> Projection only</span>
      </header>

      <div className="agent-mesh-supervisor-preview__flow-metrics" aria-label="Dependency flow summary">
        <div><strong>{stats.taskCount}</strong><span>task nodes</span></div>
        <div><strong>{stats.rootCount}</strong><span>root tasks</span></div>
        <div><strong>{stats.edgeCount}</strong><span>dependency edges</span></div>
        <div><strong>{stats.attentionCount}</strong><span>attention nodes</span></div>
        <div><strong>{stats.maxDepth + 1}</strong><span>visible layers</span></div>
      </div>

      <div className="agent-mesh-supervisor-preview__flow-layers" role="list" aria-label="Supervisor dependency layers">
        {layers.map((layer, layerIndex) => (
          <section className="agent-mesh-supervisor-preview__flow-layer" role="listitem" key={layer.depth} aria-label={`Dependency layer ${layer.depth}`}>
            <div className="agent-mesh-supervisor-preview__flow-layer-heading">
              <span>Layer {layer.depth}</span>
              <small>{layer.depth === 0 ? "No visible prerequisites" : "After prerequisite review"}</small>
            </div>
            <div className="agent-mesh-supervisor-preview__flow-nodes">
              {layer.taskIds.map((taskId) => {
                const task = byId.get(taskId);
                if (!task) return null;
                return (
                  <button
                    type="button"
                    key={task.id}
                    className={`agent-mesh-supervisor-preview__flow-node agent-mesh-supervisor-preview__flow-node--${stateTone(task.state)} ${activeTaskId === task.id ? "is-selected" : ""}`}
                    onClick={() => {
                      setActiveTaskId(task.id);
                      onSelectTask(task.id);
                    }}
                    aria-label={`${task.title}. ${stateLabel(task.state)}`}
                  >
                    <span className="agent-mesh-supervisor-preview__flow-node-icon">{stateIcon(task.state)}</span>
                    <span className="agent-mesh-supervisor-preview__flow-node-copy">
                      <strong>{task.title}</strong>
                      <small>{task.mode} · {task.owner}</small>
                      <span className={`agent-mesh-supervisor-preview__state agent-mesh-supervisor-preview__state--${stateTone(task.state)}`}>{stateIcon(task.state)} {stateLabel(task.state)}</span>
                    </span>
                    {task.dependencies.length ? <span className="agent-mesh-supervisor-preview__flow-dependencies">{task.dependencies.length} prereq{task.dependencies.length === 1 ? "" : "s"}</span> : null}
                  </button>
                );
              })}
            </div>
            {layerIndex < layers.length - 1 ? <div className="agent-mesh-supervisor-preview__flow-connector" aria-hidden="true"><ArrowDown size={14} /></div> : null}
          </section>
        ))}
      </div>

      <aside className="agent-mesh-supervisor-preview__flow-detail" aria-label="Selected dependency node">
        {selectedTask ? (
          <>
            <div className="agent-mesh-supervisor-preview__flow-detail-heading"><span className={`agent-mesh-supervisor-preview__state agent-mesh-supervisor-preview__state--${stateTone(selectedTask.state)}`}>{stateIcon(selectedTask.state)} {stateLabel(selectedTask.state)}</span><code>{selectedTask.id}</code></div>
            <h4>{selectedTask.title}</h4>
            <dl>
              <div><dt>Prerequisites</dt><dd>{selectedTask.dependencies.length ? selectedTask.dependencies.map((dependencyId) => byId.get(dependencyId)?.title ?? dependencyId).join(", ") : "None visible"}</dd></div>
              <div><dt>Downstream</dt><dd>{downstream.length ? downstream.map((task) => task.title).join(", ") : "No visible dependents"}</dd></div>
              <div><dt>Owner / mode</dt><dd>{selectedTask.owner} · {selectedTask.mode}</dd></div>
            </dl>
          </>
        ) : <p className="agent-mesh-supervisor-preview__flow-empty">Select a dependency node to inspect its local fan-in and fan-out.</p>}
      </aside>

      <p className="agent-mesh-supervisor-preview__flow-boundary"><Info size={14} /><span>Illustrative layering only. It does not prove native readiness, reorder a durable queue, evaluate provider state, or release a dependency gate.</span></p>
    </div>
  );
}
