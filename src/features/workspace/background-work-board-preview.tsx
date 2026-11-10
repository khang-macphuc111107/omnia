import {
  ArrowRight,
  Check,
  CircleDashed,
  Columns3,
  Eye,
  Info,
  Map as MapIcon,
  Pause,
  TriangleAlert,
  XCircle,
} from "lucide-react";
import { useEffect, useMemo, useState, type KeyboardEvent } from "react";

import type { BackgroundWorkRow, BackgroundWorkState } from "./background-work-inspector";

export type BackgroundWorkBoardView = "board" | "map";
export type BackgroundWorkBoardLane = "intake" | "running" | "attention" | "review" | "done";

interface LaneDefinition {
  readonly id: BackgroundWorkBoardLane;
  readonly label: string;
  readonly description: string;
  readonly states: readonly BackgroundWorkState[];
}

const LANES: readonly LaneDefinition[] = [
  { id: "intake", label: "Intake", description: "Queued or waiting work", states: ["queued", "waiting"] },
  { id: "running", label: "In progress", description: "Currently active", states: ["working"] },
  { id: "attention", label: "Attention", description: "Needs intervention", states: ["needs-input", "failed", "outcome-unknown"] },
  { id: "review", label: "Review", description: "Ready for review", states: ["ready-for-review"] },
  { id: "done", label: "Done", description: "Terminal evidence", states: ["completed", "stopped"] },
];

const stateCopy: Record<BackgroundWorkState, string> = {
  queued: "Queued",
  waiting: "Waiting",
  working: "Working",
  "needs-input": "Needs input",
  "ready-for-review": "Ready for review",
  completed: "Completed",
  failed: "Failed",
  stopped: "Stopped",
  "outcome-unknown": "Outcome unknown",
};

function laneForState(state: BackgroundWorkState): BackgroundWorkBoardLane {
  return LANES.find((lane) => lane.states.includes(state))?.id ?? "attention";
}

interface BackgroundWorkBoardSummary {
  readonly total: number;
  readonly active: number;
  readonly attention: number;
  readonly review: number;
  readonly done: number;
}

function summarizeRows(rows: readonly BackgroundWorkRow[]): BackgroundWorkBoardSummary {
  return rows.reduce<BackgroundWorkBoardSummary>(
    (summary, row) => {
      const next = { ...summary, total: summary.total + 1 };
      if (row.state === "queued" || row.state === "waiting" || row.state === "working") next.active += 1;
      if (row.state === "needs-input" || row.state === "failed" || row.state === "outcome-unknown") next.attention += 1;
      if (row.state === "ready-for-review") next.review += 1;
      if (row.state === "completed" || row.state === "stopped") next.done += 1;
      return next;
    },
    { total: 0, active: 0, attention: 0, review: 0, done: 0 },
  );
}

function stateIcon(state: BackgroundWorkState) {
  if (state === "completed") return <Check size={12} aria-hidden="true" />;
  if (state === "failed" || state === "outcome-unknown") return <XCircle size={12} aria-hidden="true" />;
  if (state === "needs-input" || state === "ready-for-review") return <TriangleAlert size={12} aria-hidden="true" />;
  if (state === "working") return <CircleDashed size={12} aria-hidden="true" />;
  if (state === "queued" || state === "waiting") return <Columns3 size={12} aria-hidden="true" />;
  return <Pause size={12} aria-hidden="true" />;
}

function BoardCard({ row, onSelect }: { readonly row: BackgroundWorkRow; readonly onSelect?: (row: BackgroundWorkRow) => void }) {
  return (
    <button
      type="button"
      className="background-work-board__card"
      onClick={() => onSelect?.(row)}
      aria-label={`${row.name}. ${stateCopy[row.state]}. ${row.summary}`}
      title={`Inspect ${row.name} in the background work board`}
    >
      <span className={`background-work-board__state background-work-board__state--${row.state}`}>
        {stateIcon(row.state)} {stateCopy[row.state]}
      </span>
      <strong>{row.name}</strong>
      <small>{row.summary}</small>
      <span className="background-work-board__meta">
        <span>{row.stageLabel ?? "Stage not reported"}</span>
        {row.eventCount !== undefined ? <span>{row.eventCount} events</span> : null}
      </span>
    </button>
  );
}

export interface BackgroundWorkBoardPreviewProps {
  readonly rows: readonly BackgroundWorkRow[];
  readonly onSelect?: (row: BackgroundWorkRow) => void;
}

/**
 * Renderer-local stage/map projection for the visible Background Work facts.
 * It intentionally does not imply a scheduler, queue mutation, agent lease,
 * or native task graph.
 */
export function BackgroundWorkBoardPreview({ rows, onSelect }: BackgroundWorkBoardPreviewProps) {
  const [view, setView] = useState<BackgroundWorkBoardView>("board");
  const [laneFilter, setLaneFilter] = useState<BackgroundWorkBoardLane | "all">("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const rowsByLane = useMemo(() => {
    const grouped = new globalThis.Map<BackgroundWorkBoardLane, BackgroundWorkRow[]>(LANES.map((lane) => [lane.id, []]));
    for (const row of rows) grouped.get(laneForState(row.state))?.push(row);
    return grouped;
  }, [rows]);
  const visibleLanes = useMemo(
    () => LANES.filter((lane) => laneFilter === "all" || lane.id === laneFilter),
    [laneFilter],
  );
  const visibleRows = useMemo(
    () => visibleLanes.flatMap((lane) => rowsByLane.get(lane.id) ?? []),
    [rowsByLane, visibleLanes],
  );
  const selected = visibleRows.find((row) => row.id === selectedId) ?? null;
  const summary = useMemo(() => summarizeRows(visibleRows), [visibleRows]);
  const viewTabs: readonly BackgroundWorkBoardView[] = ["board", "map"];

  useEffect(() => {
    if (selectedId !== null && !visibleRows.some((row) => row.id === selectedId)) {
      setSelectedId(null);
    }
  }, [selectedId, visibleRows]);

  const selectRow = (row: BackgroundWorkRow) => {
    setSelectedId(row.id);
    onSelect?.(row);
  };

  const moveViewTab = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? viewTabs.length - 1
        : (index + (event.key === "ArrowRight" ? 1 : -1) + viewTabs.length) % viewTabs.length;
    const nextView = viewTabs[nextIndex];
    if (!nextView) return;
    setView(nextView);
    document.getElementById(`background-work-board-tab-${nextView}`)?.focus();
  };

  return (
    <section className="background-work-board" aria-label="Background work stage board preview">
      <header className="background-work-board__header">
        <div>
          <span className="eyebrow"><Columns3 size={13} /> Work topology</span>
          <h2>Stage board &amp; flow map</h2>
          <p>Group visible run evidence by stage so you can scan movement and bottlenecks at a glance.</p>
        </div>
        <span className="background-work-board__badge"><Eye size={12} /> Preview</span>
      </header>

      <div className="background-work-board__toolbar" role="toolbar" aria-label="Background work board controls">
        <div className="background-work-board__view-tabs" role="tablist" aria-label="Background work topology view" aria-orientation="horizontal">
          <button id="background-work-board-tab-board" type="button" role="tab" title="Show background work grouped by stage" aria-selected={view === "board"} aria-controls="background-work-board-panel-board" tabIndex={view === "board" ? 0 : -1} className={view === "board" ? "is-active" : ""} onClick={() => setView("board")} onKeyDown={(event) => moveViewTab(event, 0)}><Columns3 size={13} /> Board</button>
          <button id="background-work-board-tab-map" type="button" role="tab" title="Show the renderer-local background work flow map" aria-selected={view === "map"} aria-controls="background-work-board-panel-map" tabIndex={view === "map" ? 0 : -1} className={view === "map" ? "is-active" : ""} onClick={() => setView("map")} onKeyDown={(event) => moveViewTab(event, 1)}><MapIcon size={13} /> Flow map</button>
        </div>
        <div className="background-work-board__lane-filter">
          <label htmlFor="background-work-board-lane">Focus lane</label>
          <select id="background-work-board-lane" value={laneFilter} onChange={(event) => setLaneFilter(event.target.value as BackgroundWorkBoardLane | "all")}>
            <option value="all">All stages</option>
            {LANES.map((lane) => <option key={lane.id} value={lane.id}>{lane.label}</option>)}
          </select>
        </div>
      </div>

      <div className="background-work-board__summary" role="status" aria-label="Visible background work board summary" aria-live="polite">
        <span><strong>{summary.total}</strong> visible</span>
        <span><strong>{summary.active}</strong> active</span>
        <span><strong>{summary.attention}</strong> attention</span>
        <span><strong>{summary.review}</strong> review</span>
        <span><strong>{summary.done}</strong> done</span>
      </div>

      {view === "board" ? (
        <div id="background-work-board-panel-board" role="tabpanel" aria-labelledby="background-work-board-tab-board" tabIndex={0} className="background-work-board__panel">
        <div className="background-work-board__lanes" role="list" aria-label="Background work stages">
          {visibleLanes.map((lane) => {
            const laneRows = rowsByLane.get(lane.id) ?? [];
            return (
              <section key={lane.id} className={`background-work-board__lane background-work-board__lane--${lane.id}`} aria-label={`${lane.label} stage`}>
                <header><span><strong>{lane.label}</strong><small>{lane.description}</small></span><b>{laneRows.length}</b></header>
                <div className="background-work-board__cards">
                  {laneRows.length > 0 ? laneRows.map((row) => <BoardCard key={row.id} row={row} onSelect={selectRow} />) : <p className="background-work-board__empty">No visible work</p>}
                </div>
              </section>
            );
          })}
        </div>
        </div>
      ) : (
        <div id="background-work-board-panel-map" role="tabpanel" aria-labelledby="background-work-board-tab-map" tabIndex={0} className="background-work-board__panel">
        <div className="background-work-board__map" role="list" aria-label="Background work flow map">
          {visibleLanes.map((lane, index) => {
            const laneRows = rowsByLane.get(lane.id) ?? [];
            return (
              <div key={lane.id} className={`background-work-board__map-node background-work-board__map-node--${lane.id}`} role="listitem">
                <div className="background-work-board__map-node-heading"><span><strong>{lane.label}</strong><small>{lane.description}</small></span><b>{laneRows.length}</b></div>
                <p>{laneRows.length === 0 ? "No visible work" : `${laneRows.length} visible item${laneRows.length === 1 ? "" : "s"}`}</p>
                {laneRows.slice(0, 2).map((row) => <button key={row.id} type="button" className="background-work-board__map-item" title={`Inspect ${row.name} in the topology preview`} onClick={() => selectRow(row)}>{stateIcon(row.state)}<span>{row.name}</span></button>)}
                {index < visibleLanes.length - 1 ? <ArrowRight className="background-work-board__connector" size={16} aria-hidden="true" /> : null}
              </div>
            );
          })}
        </div>
        </div>
      )}

      {selected ? (
        <aside className="background-work-board__selection" aria-label={`Selected topology item ${selected.name}`}>
          <span className="eyebrow">Selected preview</span>
          <strong>{selected.name}</strong>
          <span>{stateCopy[selected.state]} · {selected.stageLabel ?? "Stage not reported"}</span>
        </aside>
      ) : null}

      <p className="background-work-board__boundary"><Info size={14} /><span>Renderer-local topology preview. Moving between lanes is visual only; it does not schedule, reprioritize, dispatch, persist, or mutate native background work.</span></p>
    </section>
  );
}
